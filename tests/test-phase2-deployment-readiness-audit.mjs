import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditPath = path.join(repo, 'benchmarks/plugin-workflow-benchmark/audit-phase2-deployment-readiness.mjs');
const help = spawnSync(process.execPath, [auditPath, '--help'], { cwd: repo, encoding: 'utf8' });
assert.equal(help.status, 0, `readiness CLI help must exit before touching evidence: ${help.stderr}`);
assert.match(help.stdout, /Usage: node .*audit-phase2-deployment-readiness\.mjs \[--strict\]/);
assert.match(help.stdout, /read-only and never authorizes execution or mutates official records/);
const unknownArgument = spawnSync(process.execPath, [auditPath, '--unrecognized-option'], { cwd: repo, encoding: 'utf8' });
assert.notEqual(unknownArgument.status, 0, 'unknown readiness CLI arguments must not silently run a full audit');
assert.match(`${unknownArgument.stderr}\n${unknownArgument.stdout}`, /unknown readiness audit argument/);
const result = spawnSync(process.execPath, [auditPath], {
  cwd: repo, encoding: 'utf8',
  env: { ...process.env, PHASE2_READINESS_CANDIDATE_PATH: '', PHASE2_READINESS_INVENTORY_PATH: '' },
});
assert.equal(result.status, 0, `readiness audit should emit a report even when blocked: ${result.stderr}`);
const report = JSON.parse(result.stdout);
const snapshotPath = path.join(repo, 'benchmarks/plugin-workflow-benchmark/phase2-deployment-readiness-audit-20261013.json');
const persistedSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
// A persisted snapshot is immutable historical evidence, not a live readiness source.
// When a control script changes, the live audit fingerprint must differ; never rewrite
// the old snapshot merely to make this regression pass.
const snapshotMatchesLive = JSON.stringify(persistedSnapshot.integrity_context) === JSON.stringify(report.integrity_context);
if (!snapshotMatchesLive) {
  const changedFingerprints = Object.keys(report.integrity_context).filter(key => key.endsWith('_sha256') &&
    persistedSnapshot.integrity_context[key] !== report.integrity_context[key]);
  assert.ok(changedFingerprints.length > 0,
    'historical readiness evidence must be marked stale when any bound source/control fingerprint changes');
}
assert.equal(report.integrity_context.candidate_inventory_test_sha256,
  (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(repo, 'benchmarks/plugin-workflow-benchmark/test-phase2-candidate-package-inventory.mjs'))).digest('hex'),
  'live report must fingerprint the actual current inventory checker');
assert.equal(report.decision, 'BLOCKED_NOT_READY');
assert.equal(report.execution_permitted, false, 'read-only audit must never authorize execution');
assert.equal(report.official_records_mutated, false);
assert.equal(report.frozen_bundle.exists, false, 'expected frozen bundle must remain missing until trusted recovery');
assert.equal(report.candidate.path, 'dist/chat-on-steroids-local-orchestrator-1.0.8-candidate-review-final5-20261013.mcpb', 'live readiness must assess the current successor candidate, not stale final4');
assert.equal(report.candidate.inventory, 'PASS', 'final5 archive/source lineage must pass the current inventory check');
assert.equal(report.candidate.source_lineage, 'BLOCKED', 'historical final5 source lineage must be blocked after accepted source changes; do not rewrite its inventory');
assert.equal(report.candidate.approved, false, 'candidate must not be misrepresented as approved');
assert.equal(report.case06_draft?.sha256, '7126828e54c46f5764e684027e298d9bbfb24edfb404461b6bcd6c1588102f08', 'CASE-06 disposition must bind the v3 CASE-06 draft, not the separate v3.8 CASE-01 draft');
assert.equal(report.authorization_audit?.can_execute, false, 'consumed one-shot must remain unusable');
assert.equal(report.checks.find(check => check.id === 'authorization_audit')?.status, 'BLOCKED', 'stale consumption metadata must not be reported as a passing authorization audit');
assert.equal(report.checks.find(check => check.id === 'historical_seven_run_consumption_ledger')?.status, 'PASS', 'all seven historical run/consumption records must reconcile');
assert.equal(report.historical_authorization_ledger?.records_reviewed, 7);
assert.equal(report.historical_authorization_ledger?.unique_consumed_authorizations, 7);
for (const id of ['frozen_bundle_identity', 'fresh_exact_scope_authorization_and_gate', 'independent_candidate_review', 'case06_policy_disposition', 'static_policy_validation', 'candidate_current_source_lineage']) {
  assert.equal(report.checks.find(check => check.id === id)?.status, 'BLOCKED', `expected blocking check: ${id}`);
}
const policyBlocker = report.checks.find(check => check.id === 'static_policy_validation');
assert.match(policyBlocker.detail, /BLOCKED: frozen bundle is missing/,
  'policy validator should report a direct, actionable missing-frozen-artifact error rather than an ENOENT stack trace');
assert.match(policyBlocker.detail, /413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa/,
  'policy validator diagnostic must bind to the exact required frozen SHA-256');
const freshHost = spawnSync(process.execPath, [path.join(repo, 'benchmarks/plugin-workflow-benchmark/phase2-host-readiness-preflight.mjs')], {
  cwd: repo, encoding: 'utf8',
});
assert.ok([0, 2].includes(freshHost.status), `host preflight should return PASS or the expected blocked exit: ${freshHost.stderr}`);
const freshHostReport = JSON.parse(freshHost.stdout);
assert.equal(report.checks.find(check => check.id === 'fresh_host_preflight')?.status,
  freshHostReport.status === 'PASS' ? 'PASS' : 'BLOCKED',
  'readiness must reflect the actual current host capacity rather than a historical assumption');
assert.ok(report.host_preflight, 'a valid fail-closed host report must remain machine-readable even when its expected blocked exit code is 2');
assert.equal(report.host_preflight.status, freshHostReport.status);
assert.deepEqual(report.host_preflight.checks.map(check => ({ name: check.name, status: check.status, requirement: check.requirement })),
  freshHostReport.checks.map(check => ({ name: check.name, status: check.status, requirement: check.requirement })),
  'structured host capacity evidence must preserve the names, dispositions and requirements of every fresh check');
if (freshHostReport.status === 'BLOCKED') {
  // The host may be blocked by load, memory, storage, or a missing sandbox
  // prerequisite. Do not bind this regression to yesterday's specific disk
  // failure: that made an otherwise correct preflight fail when disk recovers
  // and a different measured check (for example host-load) remains blocked.
  const failedChecks = report.host_preflight.checks.filter(check => check.status === 'FAIL');
  assert.ok(failedChecks.length > 0, 'BLOCKED host evidence must identify at least one current measured failing check');
  assert.ok(failedChecks.every(check => typeof check.name === 'string' && check.name && typeof check.requirement === 'string' && check.requirement),
    'every failing host check must retain a named condition and its exact requirement');
}
assert.equal(report.checks.find(check => check.id === 'sandbox_containment_probe')?.status, 'PASS');
assert.equal(report.checks.find(check => check.id === 'candidate_inventory_integrity')?.status, 'PASS', 'the current final5 candidate must pass byte lineage while remaining unapproved');
assert.match(report.checks.find(check => check.id === 'case06_policy_disposition')?.detail || '', /7126828e54c46f5764e684027e298d9bbfb24edfb404461b6bcd6c1588102f08/, 'CASE-06 blocker must name the correct draft hash');
const strict = spawnSync(process.execPath, [auditPath, '--strict'], {
  cwd: repo, encoding: 'utf8',
  env: { ...process.env, PHASE2_READINESS_CANDIDATE_PATH: '', PHASE2_READINESS_INVENTORY_PATH: '' },
});
assert.equal(strict.status, 2, 'strict mode must exit non-zero while any readiness blocker remains');
const liveCandidate = process.env.PHASE2_READINESS_CANDIDATE_PATH || '';
const liveInventory = process.env.PHASE2_READINESS_INVENTORY_PATH || '';
assert.equal(Boolean(liveCandidate), Boolean(liveInventory), 'successor readiness validation requires an explicit candidate/inventory pair; historical defaults must not masquerade as current source');
if (liveCandidate && liveInventory) {
  const successor = spawnSync(process.execPath, [auditPath], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, PHASE2_READINESS_CANDIDATE_PATH: liveCandidate, PHASE2_READINESS_INVENTORY_PATH: liveInventory },
  });
  assert.equal(successor.status, 0, `readiness audit must emit a report for an explicitly bound review-only successor: ${successor.stderr}`);
  const successorReport = JSON.parse(successor.stdout);
  assert.equal(successorReport.candidate.path, liveCandidate, 'successor audit must identify the exact selected candidate path');
  assert.equal(successorReport.candidate.sha256,
    (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(repo, liveCandidate))).digest('hex'),
    'successor audit must bind the actual selected candidate bytes');
  assert.equal(successorReport.candidate.inventory, 'PASS', 'successor inventory and archive bytes must reconcile');
  assert.equal(successorReport.candidate.source_lineage, 'PASS', 'successor must bind to the current packaged source bytes');
  assert.equal(successorReport.decision, 'BLOCKED_NOT_READY', 'correct source lineage cannot substitute for authority prerequisites');
  assert.equal(successorReport.execution_permitted, false);
  assert.equal(successorReport.official_records_mutated, false);
} else {
  console.log('INFO: no explicit current successor pair supplied; preserved historical candidates are not treated as current-source readiness evidence');
}
const unsafeOverride = spawnSync(process.execPath, [auditPath], {
  cwd: repo, encoding: 'utf8',
  env: { ...process.env, PHASE2_READINESS_CANDIDATE_PATH: '../outside.mcpb', PHASE2_READINESS_INVENTORY_PATH: liveInventory },
});
assert.notEqual(unsafeOverride.status, 0, 'readiness candidate overrides must reject repository traversal');
assert.match(`${unsafeOverride.stderr}\n${unsafeOverride.stdout}`, /repository-relative path/);

// A full /tmp tmpfs can still report free blocks while the invoking user's
// usrquota rejects writes with errno -122. Exercise the audit with /tmp as the
// preferred scratch path, but do not assume the quota is currently exhausted:
// the correct outcome is PASS when the probe works and WARN with a verified
// fallback when it fails. Neither branch may weaken containment or readiness.
const quotaFallback = spawnSync(process.execPath, [auditPath], {
  cwd: repo, encoding: 'utf8', timeout: 60_000,
  env: {
    ...process.env,
    TMPDIR: '/tmp',
    PHASE2_READINESS_CANDIDATE_PATH: liveCandidate,
    PHASE2_READINESS_INVENTORY_PATH: liveInventory,
  },
});
assert.equal(quotaFallback.status, 0, `audit must remain machine-readable when /tmp user quota is exhausted: ${quotaFallback.stderr}`);
const quotaReport = JSON.parse(quotaFallback.stdout);
assert.equal(quotaReport.candidate.inventory, 'PASS', 'temporary storage quota must not be misreported as candidate inventory corruption');
assert.equal(quotaReport.candidate.source_lineage, 'PASS', 'scratch fallback must preserve exact source/package lineage validation');
assert.equal(quotaReport.checks.find(check => check.id === 'sandbox_containment_probe')?.status, 'PASS',
  'scratch fallback must still run the full containment probe, not skip it');
const scratchCheck = quotaReport.checks.find(check => check.id === 'scratch_storage');
assert.ok(['PASS', 'WARN'].includes(scratchCheck?.status),
  'scratch storage must either pass its preferred path probe or report the validated fallback as a warning');
if (scratchCheck.status === 'WARN') {
  assert.match(scratchCheck.detail || '', /\/tmp.*-122.*\/var\/tmp/s,
    'a failed preferred scratch probe must preserve errno -122 and the selected fallback path');
} else {
  assert.match(scratchCheck.detail || '', /preferred=\/tmp; private write\/fsync probe passed/,
    'a successful preferred scratch probe must be reported honestly without claiming fallback use');
}
assert.equal(quotaReport.decision, 'BLOCKED_NOT_READY', 'scratch fallback must not remove unrelated release blockers');
assert.equal(quotaReport.execution_permitted, false);
assert.equal(quotaReport.official_records_mutated, false);
console.log(`PASS: Phase 2 live audit fails closed with ${report.blocker_count} blockers; historical snapshot ${snapshotMatchesLive ? 'matches' : 'is stale and preserved'}; no authorization or execution is performed`);
