#!/usr/bin/env node
// Read-only, fail-closed summary of Phase 2 deployment prerequisites.
// This report cannot issue authorization, mutate official records, or open the gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, readVerifiedRepoFile, validateCandidateReviewRecord, validateCase06Disposition, validateFreshAuthorization } from './phase2-approval-contract.mjs';
import { isSafePortableArchivePath, validateZipEntryTypes } from './phase2-zip-entry-type-safety.mjs';
import { serializePluginPackageMetadata } from '../../scripts/plugin-package-metadata.mjs';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node benchmarks/plugin-workflow-benchmark/audit-phase2-deployment-readiness.mjs [--strict]');
  console.log('Optional environment: PHASE2_READINESS_CANDIDATE_PATH and PHASE2_READINESS_INVENTORY_PATH must be paired, clean repository-relative paths.');
  console.log('--strict exits 2 when blockers remain. This audit is read-only and never authorizes execution or mutates official records.');
  process.exit(0);
}
const unknownArguments = process.argv.slice(2).filter(argument => argument !== '--strict');
if (unknownArguments.length) throw new Error(`unknown readiness audit argument(s): ${unknownArguments.join(', ')}; use --help`);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const readJsonEvidence = file => {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(`${repo}${path.sep}`)) throw new Error('JSON evidence path escapes repository root');
  const relative = path.relative(repo, absolute).split(path.sep).join('/');
  const verified = readVerifiedRepoFile(repo, relative, 'JSON evidence');
  return { ...verified, value: parseStrictJson(verified.bytes, `JSON evidence ${relative}`) };
};
const readJson = file => readJsonEvidence(file).value;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expectedFrozenSha = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const base = path.join(repo, 'benchmarks/plugin-workflow-benchmark');
function resolveEvidencePath(environmentKey, fallbackRelativePath) {
  const relative = process.env[environmentKey] || fallbackRelativePath;
  const parts = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || relative.includes('\\') ||
      parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`${environmentKey} must be a clean repository-relative path`);
  }
  const resolved = path.resolve(repo, relative);
  if (!resolved.startsWith(`${repo}${path.sep}`)) throw new Error(`${environmentKey} escapes the repository`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${environmentKey} must identify an existing regular non-symlink file`);
  }
  return resolved;
}
// Trust anchor is provisioned out-of-band. A reference embedded in a decision
// packet is descriptive and cannot establish reviewer/authority identity.
let trustedAuthorityPublicKey = null;
let authorityTrustAnchorSha256 = null;
const trustAnchorPath = process.env.PHASE2_AUTHORITY_TRUSTED_PUBLIC_KEY_FILE;
if (trustAnchorPath) {
  try {
    const absoluteTrustPath = path.resolve(trustAnchorPath);
    const trustBytes = readVerifiedRepoFile(path.dirname(absoluteTrustPath), path.basename(absoluteTrustPath), 'authority trust anchor').bytes;
    trustedAuthorityPublicKey = trustBytes.toString('utf8');
    authorityTrustAnchorSha256 = sha256(trustBytes);
  } catch { /* validators fail closed when no usable trust anchor is available */ }
}
const manifestPath = path.join(base, 'runs/phase2-preparation-20261010/run-manifest.json');
const specPath = path.join(base, 'scenario-execution-spec-v3.8-draft.json');
const case06SpecPath = path.join(base, 'scenario-execution-spec-v3-draft.json');
const frozenPath = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const candidatePath = resolveEvidencePath('PHASE2_READINESS_CANDIDATE_PATH', 'dist/chat-on-steroids-local-orchestrator-1.0.8-candidate-review-final5-20261013.mcpb');
const inventoryPath = resolveEvidencePath('PHASE2_READINESS_INVENTORY_PATH', 'benchmarks/plugin-workflow-benchmark/phase2-candidate-package-inventory-final5-20261013.json');
// Parse and hash each authority/evidence document from one descriptor read. Do
// not parse a spec, re-open its path for the signature hash, then accidentally
// combine bytes from different inode generations if the path is replaced.
const manifestEvidence = readJsonEvidence(manifestPath);
const specEvidence = readJsonEvidence(specPath);
const inventoryEvidence = readJsonEvidence(inventoryPath);
const manifest = manifestEvidence.value;
const spec = specEvidence.value;
const inventoryRecord = inventoryEvidence.value;
let candidateBundleEvidence = null;
try {
  candidateBundleEvidence = readVerifiedRepoFile(repo, path.relative(repo, candidatePath).split(path.sep).join('/'), 'candidate bundle');
} catch { /* exact candidate identity is reported as blocked below */ }
const blockers = [];
const checks = [];

function check(id, passed, detail, blocking = true) {
  checks.push({ id, status: passed ? 'PASS' : (blocking ? 'BLOCKED' : 'WARN'), detail });
  if (!passed && blocking) blockers.push({ id, detail });
}

function probeScratchDirectory(directory, requiredBytes = 0) {
  let probeDirectory = null;
  try {
    const entry = fs.lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('scratch path must be a real directory, not a symlink');
    const canonical = fs.realpathSync(directory);
    if (canonical !== directory) throw new Error('scratch path must be canonical');
    probeDirectory = fs.mkdtempSync(path.join(canonical, '.phase2-readiness-scratch-probe-'));
    const probeFile = path.join(probeDirectory, 'write-probe');
    const fd = fs.openSync(probeFile, 'wx', 0o600);
    const probeBytes = Math.max(4 * 1024 * 1024, requiredBytes + 1024 * 1024);
    try {
      // A tiny successful write is not a capacity check: tmpfs usrquota may
      // permit a few bytes but reject the candidate snapshot or sandbox files
      // with errno -122. Probe enough space for the actual archive plus headroom.
      fs.writeFileSync(fd, Buffer.alloc(probeBytes, 0x5a));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { ok: true, path: canonical, probe_bytes: probeBytes };
  } catch (error) {
    return {
      ok: false,
      path: directory,
      error: {
        code: error?.code || null,
        errno: Number.isInteger(error?.errno) ? error.errno : null,
        syscall: error?.syscall || null,
        message: error?.message || String(error),
      },
    };
  } finally {
    // Only remove the uniquely created probe directory, never an existing path.
    if (probeDirectory) {
      try { fs.rmSync(probeDirectory, { recursive: true, force: true }); } catch {}
    }
  }
}

const preferredScratchPath = os.tmpdir();
const requiredScratchBytes = candidateBundleEvidence?.bytes.length ?? 0;
const preferredScratch = probeScratchDirectory(preferredScratchPath, requiredScratchBytes);
let scratchRoot = preferredScratch.ok ? preferredScratch.path : null;
let scratchFallback = null;
if (!scratchRoot && preferredScratchPath !== '/var/tmp') {
  scratchFallback = probeScratchDirectory('/var/tmp', requiredScratchBytes);
  if (scratchFallback.ok) scratchRoot = scratchFallback.path;
}
const scratchFallbackUsed = Boolean(scratchRoot && !preferredScratch.ok);
const scratchDiagnostic = preferredScratch.ok
  ? `preferred=${preferredScratch.path}; private write/fsync probe passed`
  : `preferred=${preferredScratchPath} failed (code=${preferredScratch.error.code}; errno=${preferredScratch.error.errno}; syscall=${preferredScratch.error.syscall}; ${preferredScratch.error.message}); fallback=/var/tmp ${scratchFallback?.ok ? 'passed' : `failed (${scratchFallback?.error?.message || 'not attempted'})`}; selected=${scratchRoot || 'NONE'}`;
check('scratch_storage', Boolean(scratchRoot) && !scratchFallbackUsed, scratchDiagnostic, !scratchRoot);

let candidateArchiveTypeCheck = { valid: false, detail: 'candidate bytes are missing or unverified' };
if (candidateBundleEvidence) {
  try {
    const zipInfo = validateZipEntryTypes(candidateBundleEvidence.bytes);
    candidateArchiveTypeCheck = { valid: true, detail: `validated ${zipInfo.entries} ZIP central-directory entries; symlinks and special files are rejected` };
  } catch (error) {
    candidateArchiveTypeCheck = { valid: false, detail: `candidate archive entry-type validation failed: ${error.message}` };
  }
}
check('candidate_archive_entry_types', candidateArchiveTypeCheck.valid, candidateArchiveTypeCheck.detail);

let frozenExists = false;
let frozenHash = null;
let frozenReadError = null;
try {
  const frozenBytes = readVerifiedRepoFile(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb', 'official frozen bundle');
  frozenExists = true;
  frozenHash = frozenBytes.sha256;
} catch (error) { frozenReadError = error; }
const frozenDetail = frozenExists
  ? `expected SHA-256 ${expectedFrozenSha}; observed ${frozenHash}`
  : frozenReadError?.code === 'ENOENT'
    ? `expected frozen bundle is absent; required SHA-256 ${expectedFrozenSha}`
    : `official frozen bundle bytes could not be securely verified: ${frozenReadError?.message || 'unknown error'}; required SHA-256 ${expectedFrozenSha}`;
check('frozen_bundle_identity', frozenExists && frozenHash === expectedFrozenSha, frozenDetail);

check('manifest_not_started', manifest.protocol?.status === 'not-started' && manifest.assessment?.final_status === 'not-started',
  `protocol=${manifest.protocol?.status}; assessment=${manifest.assessment?.final_status}`);
const embeddedAuthorization = spec.execution_gate?.authorization_record;
let authorizationRecord = null;
let authorizationConsumption = null;
let authorizationContract = { valid: false, errors: ['no embedded fresh authorization record'] };
if (embeddedAuthorization && typeof embeddedAuthorization.authorization_record_path === 'string') {
  try {
    const recordBytes = readVerifiedRepoFile(repo, embeddedAuthorization.authorization_record_path, 'authorization record');
    authorizationRecord = parseStrictJson(recordBytes.bytes, 'authorization record');
    const authorizedSpecBytes = readVerifiedRepoFile(repo, authorizationRecord.authorized_execution_spec_path, 'authorized execution spec');
    const currentAuthorizedSpecSha256 = authorizedSpecBytes.sha256;
    if (typeof authorizationRecord.consumption_record_path === 'string') {
      try {
        const consumptionBytes = readVerifiedRepoFile(repo, authorizationRecord.consumption_record_path, 'authorization consumption record');
        authorizationConsumption = parseStrictJson(consumptionBytes.bytes, 'authorization consumption record');
      } catch (error) {
        // Missing consumption evidence is distinct from unsafe/corrupt evidence.
        // The validator will reject any one-shot whose signed record is already
        // marked consumed; path traversal and symlinks must not be probed outside
        // the repository or silently treated as an absent record.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    authorizationContract = validateFreshAuthorization({
      spec, record: authorizationRecord, consumption: authorizationConsumption, repoRoot: repo,
      currentSpecSha256: specEvidence.sha256, currentAuthorizedSpecSha256, frozenSha256: frozenHash,
      expectedSourceTreeIdentity: inventoryRecord.source_tree,
      priorDecisionIds: (spec.execution_gate?.previous_authorization_records || []).map(item => item.decision_id),
      trustedAuthorityPublicKey,
    });
  } catch (error) {
    authorizationContract = { valid: false, errors: [`cannot verify authorization/consumption record: ${error.message}`] };
  }
}
const gateReady = spec.status !== 'draft-not-authorized' && spec.execution_gate?.status === 'open' && authorizationContract.valid;
check('fresh_exact_scope_authorization_and_gate', gateReady,
  `spec=${spec.status}; gate=${spec.execution_gate?.status}; authorized_case_ids=${JSON.stringify(spec.execution_gate?.authorized_case_ids)}; authorization_contract=${authorizationContract.valid ? 'PASS' : 'BLOCKED'}; details=${authorizationContract.errors.join('; ') || 'exact-scope authorization verified'}; only the established authority may change these records`);

const candidateReviewPath = path.join(base, 'phase2-candidate-independent-review-final5-20261013.json');
let candidateReview = null;
if (fs.existsSync(candidateReviewPath)) {
  try { candidateReview = readJson(candidateReviewPath); } catch { /* reported below */ }
}
const currentCandidateHash = candidateBundleEvidence?.sha256 || null;
let candidateReviewValidation = { valid: false, errors: ['review record missing or unreadable'] };
if (candidateReview && inventoryEvidence) {
  try {
    candidateReviewValidation = validateCandidateReviewRecord({
      record: candidateReview, candidatePath: path.relative(repo, candidatePath), candidateSha256: currentCandidateHash,
      sourceTreeIdentity: inventoryRecord.source_tree,
      trustedAuthorityPublicKey,
    });
  } catch (error) { candidateReviewValidation = { valid: false, errors: [`review validation failed: ${error.message}`] }; }
}
const candidateReviewPass = Boolean(currentCandidateHash && candidateReviewValidation.valid);
check('independent_candidate_review', candidateReviewPass,
  candidateReviewPass ? `approved by ${candidateReview.reviewer_id} for exact candidate hash ${candidateReview.candidate_sha256}` :
    `expected candidate=${path.relative(repo, candidatePath)} SHA-256=${currentCandidateHash ?? 'MISSING'}; source inventory=${path.relative(repo, inventoryPath)}; missing, stale, or incomplete phase2-candidate-independent-review-final5-20261013.json: ${candidateReviewValidation.errors.join('; ')}`);

const case06DispositionPath = path.join(base, 'phase2-case06-policy-disposition-20261013.json');
let case06Disposition = null;
if (fs.existsSync(case06DispositionPath)) {
  try { case06Disposition = readJson(case06DispositionPath); } catch { /* reported below */ }
}
const case06SpecHash = readVerifiedRepoFile(repo, path.relative(repo, case06SpecPath).split(path.sep).join('/'), 'CASE-06 source spec').sha256;
const case06DispositionValidation = validateCase06Disposition({
  record: case06Disposition, expectedSpecPath: path.relative(repo, case06SpecPath), expectedSpecSha256: case06SpecHash,
  trustedAuthorityPublicKey,
});
const case06Pass = case06DispositionValidation.valid;
check('case06_policy_disposition', case06Pass,
  case06Pass ? `accepted by ${case06Disposition.reviewer_id} for CASE-06 draft SHA-256 ${case06Disposition.source_spec_sha256}` :
    `expected source=${path.relative(repo, case06SpecPath)} SHA-256=${case06SpecHash}; missing, stale, or incomplete phase2-case06-policy-disposition-20261013.json: ${case06DispositionValidation.errors.join('; ')}`);

const hostPreflightRun = spawnSync(process.execPath, [path.join(base, 'phase2-host-readiness-preflight.mjs')], { cwd: repo, encoding: 'utf8' });
let hostPreflight = null;
if ([0, 2].includes(hostPreflightRun.status)) {
  try { hostPreflight = JSON.parse(hostPreflightRun.stdout); } catch { /* reported below */ }
}
check('fresh_host_preflight', hostPreflightRun.status === 0 && hostPreflight?.status === 'PASS',
  hostPreflight ? `captured_at=${hostPreflight.captured_at}; status=${hostPreflight.status}` : `preflight exit=${hostPreflightRun.status}; ${(hostPreflightRun.stderr || hostPreflightRun.stdout || '').trim()}`);

const sandboxProbeRun = spawnSync(process.execPath, [path.join(base, 'test-scenario-sandbox.mjs')], {
  cwd: repo, encoding: 'utf8', timeout: 30000,
  env: { ...process.env, ...(scratchRoot ? { TMPDIR: scratchRoot } : {}) },
});
let sandboxProbe = null;
if ([0, 2].includes(sandboxProbeRun.status)) {
  try { sandboxProbe = JSON.parse(sandboxProbeRun.stdout); } catch { /* reported below */ }
}
check('sandbox_containment_probe', sandboxProbeRun.status === 0 && sandboxProbe?.status === 'PASS',
  sandboxProbe ? `status=${sandboxProbe.status}; backend=${sandboxProbe.sandbox_policy?.backend}; assertions=${sandboxProbe.assertions?.length ?? 0}` : `probe exit=${sandboxProbeRun.status}; ${(sandboxProbeRun.stderr || sandboxProbeRun.stdout || '').trim()}`);

let candidateInfo = { path: path.relative(repo, candidatePath), exists: Boolean(candidateBundleEvidence), inventory: 'not-checked' };
if (candidateInfo.exists && inventoryEvidence) {
  let candidateSnapshotDir = null;
  try {
    const inventory = inventoryRecord;
    const archive = candidateBundleEvidence.bytes;
    const archiveHash = candidateBundleEvidence.sha256;
    // ZIP tools must consume a private snapshot of the exact buffer read and
    // hashed through the verified descriptor; repeatedly opening candidatePath
    // could otherwise mix archive generations during one readiness decision.
    if (!scratchRoot) throw new Error(`no writable scratch directory available: ${scratchDiagnostic}`);
    candidateSnapshotDir = fs.mkdtempSync(path.join(scratchRoot, 'phase2-readiness-candidate-'));
    fs.chmodSync(candidateSnapshotDir, 0o700);
    const candidateSnapshotPath = path.join(candidateSnapshotDir, 'candidate.mcpb');
    const candidateSnapshotFd = fs.openSync(candidateSnapshotPath, 'wx', 0o600);
    try {
      fs.writeFileSync(candidateSnapshotFd, archive);
      fs.fsyncSync(candidateSnapshotFd);
    } finally { fs.closeSync(candidateSnapshotFd); }
    fs.chmodSync(candidateSnapshotPath, 0o400);

    const names = execFileSync('unzip', ['-Z1', candidateSnapshotPath], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(name => name && !name.endsWith('/')).sort();
    const entries = Array.isArray(inventory.entries) ? inventory.entries : [];
    const listed = entries.map(entry => entry.path).sort();
    const archiveMetadataMatches = inventory.bundle?.sha256 === archiveHash && inventory.bundle?.size_bytes === archive.length;
    const entriesMatch = JSON.stringify(names) === JSON.stringify(listed);
    const safeEntryNames = entries.every(entry => isSafePortableArchivePath(entry.path));
    const uniqueEntryNames = new Set(listed).size === listed.length && new Set(names).size === names.length;
    const perEntryMatch = entriesMatch && safeEntryNames && uniqueEntryNames && entries.every(entry => {
      const bytes = execFileSync('unzip', ['-p', candidateSnapshotPath, entry.path], { maxBuffer: 32 * 1024 * 1024 });
      return bytes.length === entry.size_bytes && sha256(bytes) === entry.sha256;
    });
    const sourceLineageMatches = entries.every(entry => {
      const expectedSourcePath = entry.path === 'manifest.json' ? 'plugin/manifest.json' : entry.path;
      if (entry.source_path !== expectedSourcePath || entry.source_sha256 !== entry.sha256) return false;
      const archiveBytes = execFileSync('unzip', ['-p', candidateSnapshotPath, entry.path], { maxBuffer: 32 * 1024 * 1024 });
      if (entry.path === 'package.json') {
        const sourcePackage = readVerifiedRepoFile(repo, 'package.json', 'candidate source package.json input');
        const expectedPackageBytes = serializePluginPackageMetadata(parseStrictJson(sourcePackage.bytes, 'repository package.json'));
        return entry.source_derivation === 'runtime-metadata-projection-v1' &&
          entry.source_input_sha256 === sourcePackage.sha256 &&
          sha256(expectedPackageBytes) === entry.source_sha256 && expectedPackageBytes.equals(archiveBytes);
      }
      if (entry.source_derivation !== undefined || entry.source_input_sha256 !== undefined) return false;
      const source = readVerifiedRepoFile(repo, entry.source_path, `candidate source ${entry.source_path}`);
      return source.bytes.length === entry.size_bytes && source.sha256 === entry.source_sha256 && source.bytes.equals(archiveBytes);
    });
    const sourceInventoryHash = sha256(Buffer.from(JSON.stringify(entries.map(entry => ({
      path: entry.source_path, sha256: entry.source_sha256,
      ...(entry.source_input_sha256 ? { source_input_sha256: entry.source_input_sha256, source_derivation: entry.source_derivation } : {})
    })))));
    const currentGitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const sourceIdentityMatches = inventory.source_tree?.git_head === currentGitHead &&
      inventory.source_tree?.packaged_source_inventory_sha256 === sourceInventoryHash &&
      inventory.source_tree?.working_tree_dirty === true;
    const manifest = parseStrictJson(execFileSync('unzip', ['-p', candidateSnapshotPath, 'manifest.json']), 'candidate package manifest');
    const manifestMatches = inventory.manifest?.name === manifest.name &&
      inventory.manifest?.version === manifest.version &&
      inventory.manifest?.server_entry_point === manifest.server?.entry_point &&
      inventory.manifest?.declared_tool_count === manifest.tools?.length;
    const inventoryIsExplicitlyUnapproved = inventory.status === 'candidate-unapproved-review-evidence-only' &&
      inventory.bundle?.path === path.relative(repo, candidatePath);
    // Recheck the candidate name/inode after verifying its private snapshot. A
    // replacement during the audit invalidates identity; a same-UID change after
    // the final recheck remains an explicit filesystem limitation.
    const candidatePathRecheck = readVerifiedRepoFile(repo, path.relative(repo, candidatePath).split(path.sep).join('/'), 'candidate final identity');
    const candidatePathStable = candidatePathRecheck.sha256 === archiveHash && candidatePathRecheck.bytes.equals(archive);
    const archiveIdentityMatches = archiveMetadataMatches && candidatePathStable;
    // Keep archive/inventory self-integrity distinct from current-source lineage.
    // A valid historical candidate whose packaged files no longer match the dirty
    // working tree is stale, not a corrupt archive; it must remain unreviewable.
    const inventoryPass = archiveIdentityMatches && entriesMatch && safeEntryNames && uniqueEntryNames &&
      perEntryMatch && manifestMatches && inventoryIsExplicitlyUnapproved;
    const sourceLineagePass = sourceLineageMatches && sourceIdentityMatches;
    candidateInfo = { ...candidateInfo, size_bytes: archive.length, sha256: archiveHash, inventory: inventoryPass ? 'PASS' : 'FAIL', source_lineage: sourceLineagePass ? 'PASS' : 'BLOCKED', entry_count: names.length, approved: false };
    check('candidate_inventory_integrity', candidateInfo.inventory === 'PASS',
      `candidate SHA-256=${archiveHash}; entries=${names.length}; archive_identity_and_path_stability=${archiveIdentityMatches}; entries_match=${entriesMatch}; safe_unique_names=${safeEntryNames && uniqueEntryNames}; source_lineage=${sourceLineageMatches}; source_identity=${sourceIdentityMatches}; manifest_matches=${manifestMatches}; explicitly_unapproved_inventory=${inventoryIsExplicitlyUnapproved}; inventory=${candidateInfo.inventory}`);
    check('candidate_current_source_lineage', sourceLineagePass,
      `source-to-package lineage=${sourceLineageMatches}; source-tree identity matches current checkout=${sourceIdentityMatches}; mismatched current source means candidate must not be reviewed or authorized`);
  } catch (error) {
    candidateInfo.inventory = `ERROR: ${error.message}`;
    check('candidate_inventory_integrity', false, candidateInfo.inventory);
  } finally {
    if (candidateSnapshotDir) fs.rmSync(candidateSnapshotDir, { recursive: true, force: true });
  }
} else {
  check('candidate_inventory_integrity', false, 'candidate package or inventory is absent or not securely readable; candidate review cannot be validated without its exact inventory');
}

const policy = spawnSync(process.execPath, [path.join(base, 'validate-scenario-policy.mjs')], { cwd: repo, encoding: 'utf8' });
const policyOutput = `${policy.stdout || ''}${policy.stderr || ''}`.trim().split(/\r?\n/).slice(-5).join(' | ');
check('static_policy_validation', policy.status === 0, policy.status === 0 ? 'validator passed' : `validator exit=${policy.status}; ${policyOutput}`);

const authorizationAudit = spawnSync(process.execPath, [path.join(base, 'audit-phase2-v38-authorization-state.mjs')], { cwd: repo, encoding: 'utf8' });
let authorization = null;
if (authorizationAudit.status === 0) {
  try { authorization = JSON.parse(authorizationAudit.stdout); } catch { /* reported below */ }
}
check('authorization_audit', authorizationAudit.status === 0 && authorization?.can_execute === false &&
  authorization?.official_gate_closed === true && authorization?.prior_authorization_consumed === true &&
  authorization?.authorization_record_metadata_stale === false && authorization?.source_spec_hash_matches === true &&
  authorization?.authorized_execution_spec_hash_matches === true && authorization?.scope_matches_expected_restrictions === true,
  authorization ? `decision=${authorization.decision}; gate_closed=${authorization.official_gate_closed}; prior_consumed=${authorization.prior_authorization_consumed}; stale_metadata=${authorization.authorization_record_metadata_stale}; source_hash_match=${authorization.source_spec_hash_matches}; authorized_spec_hash_match=${authorization.authorized_execution_spec_hash_matches}; scope_match=${authorization.scope_matches_expected_restrictions}; can_execute=${authorization.can_execute}` : `audit failed: ${(authorizationAudit.stderr || authorizationAudit.stdout || '').trim()}`);

const historicalLedgerRun = spawnSync(process.execPath, [path.join(base, 'audit-phase2-step1-evidence.mjs')], { cwd: repo, encoding: 'utf8' });
let historicalLedger = null;
if (historicalLedgerRun.status === 0) {
  try { historicalLedger = parseStrictJson(historicalLedgerRun.stdout, 'historical authorization ledger audit output'); } catch { /* reported below */ }
}
const historicalLedgerPass = historicalLedgerRun.status === 0 && historicalLedger?.records_reviewed === 7 &&
  historicalLedger?.unique_consumed_authorizations === 7 && historicalLedger?.all_consumption_records_reconcile === true &&
  historicalLedger?.official_gate_closed === true && historicalLedger?.official_manifest_not_started === true;
check('historical_seven_run_consumption_ledger', historicalLedgerPass,
  historicalLedger ? `records=${historicalLedger.records_reviewed}; unique_consumed=${historicalLedger.unique_consumed_authorizations}; reconciled=${historicalLedger.all_consumption_records_reconcile}; gate_closed=${historicalLedger.official_gate_closed}; manifest_not_started=${historicalLedger.official_manifest_not_started}` :
    `ledger audit exit=${historicalLedgerRun.status}; ${(historicalLedgerRun.stderr || historicalLedgerRun.stdout || '').trim()}`);

const currentGitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const fileHashOrNull = file => fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
const currentInventory = inventoryRecord;
const integrityContext = {
  git_head: currentGitHead,
  source_tree_identity: currentInventory.source_tree,
  readiness_audit_sha256: fileHashOrNull(path.join(base, 'audit-phase2-deployment-readiness.mjs')),
  approval_contract_sha256: fileHashOrNull(path.join(base, 'phase2-approval-contract.mjs')),
  readiness_test_sha256: fileHashOrNull(path.join(repo, 'tests/test-phase2-deployment-readiness-audit.mjs')),
  approval_contract_test_sha256: fileHashOrNull(path.join(base, 'test-phase2-approval-contract.mjs')),
  candidate_inventory_test_sha256: fileHashOrNull(path.join(base, 'test-phase2-candidate-package-inventory.mjs')),
  candidate_inventory_builder_sha256: fileHashOrNull(path.join(base, 'create-phase2-candidate-inventory.mjs')),
  candidate_inventory_builder_test_sha256: fileHashOrNull(path.join(base, 'test-create-phase2-candidate-inventory.mjs')),
  review_artifacts_test_sha256: fileHashOrNull(path.join(base, 'test-phase2-review-artifacts.mjs')),
  runtime_artifact_validator_sha256: fileHashOrNull(path.join(repo, 'src/runtime/workflow/artifacts.js')),
  runtime_artifact_test_sha256: fileHashOrNull(path.join(repo, 'tests/test-m6-reviewer-artifact.js')),
  authorization_state_audit_sha256: fileHashOrNull(path.join(base, 'audit-phase2-v38-authorization-state.mjs')),
  historical_ledger_audit_sha256: fileHashOrNull(path.join(base, 'audit-phase2-step1-evidence.mjs')),
  package_metadata_sha256: fileHashOrNull(path.join(repo, 'package.json')),
  npm_lock_sha256: fileHashOrNull(path.join(repo, 'package-lock.json')),
  pnpm_lock_sha256: fileHashOrNull(path.join(repo, 'pnpm-lock.yaml')),
  candidate_sha256: fileHashOrNull(candidatePath),
  candidate_inventory_sha256: fileHashOrNull(inventoryPath),
  successor_candidate_sha256: fileHashOrNull(path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8-candidate-review-final5-20261013.mcpb')),
  successor_candidate_inventory_sha256: fileHashOrNull(path.join(base, 'phase2-candidate-package-inventory-final5-20261013.json')),
  case01_spec_sha256: fileHashOrNull(specPath),
  case06_spec_sha256: fileHashOrNull(case06SpecPath),
  official_manifest_sha256: fileHashOrNull(manifestPath),
  authority_trust_anchor_sha256: authorityTrustAnchorSha256,
};

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  integrity_context: integrityContext,
  decision: blockers.length ? 'BLOCKED_NOT_READY' : 'READY_FOR_INDEPENDENT_FINAL_CHECK',
  execution_permitted: false,
  official_records_mutated: false,
  frozen_bundle: { path: path.relative(repo, frozenPath), expected_sha256: expectedFrozenSha, exists: frozenExists, observed_sha256: frozenHash },
  candidate: candidateInfo,
  independent_candidate_review: candidateReview ? { path: path.relative(repo, candidateReviewPath), status: candidateReview.status, candidate_sha256: candidateReview.candidate_sha256, reviewer_id: candidateReview.reviewer_id } : null,
  case06_draft: { path: path.relative(repo, case06SpecPath), sha256: case06SpecHash },
  case06_policy_disposition: case06Disposition ? { path: path.relative(repo, case06DispositionPath), decision: case06Disposition.decision, source_spec_sha256: case06Disposition.source_spec_sha256, reviewer_id: case06Disposition.reviewer_id } : null,
  host_preflight: hostPreflight ? { captured_at: hostPreflight.captured_at, status: hostPreflight.status, checks: hostPreflight.checks } : null,
  sandbox_containment: sandboxProbe ? { status: sandboxProbe.status, sandbox_policy: sandboxProbe.sandbox_policy, assertions: sandboxProbe.assertions } : null,
  authorization_audit: authorization,
  historical_authorization_ledger: historicalLedger ? {
    records_reviewed: historicalLedger.records_reviewed,
    unique_consumed_authorizations: historicalLedger.unique_consumed_authorizations,
    all_consumption_records_reconcile: historicalLedger.all_consumption_records_reconcile,
    all_plugin_lineage_statuses_unverified_or_invalid: historicalLedger.all_plugin_lineage_statuses_unverified_or_invalid,
    official_gate_closed: historicalLedger.official_gate_closed,
    official_manifest_not_started: historicalLedger.official_manifest_not_started,
  } : null,
  blocker_count: blockers.length,
  blockers,
  checks,
  next_actions: [
    'Restore the exact frozen bundle from trusted custody and verify its SHA-256, or complete the formal re-freeze/review process.',
    'Obtain independent technical approval bound to the exact bundle SHA-256.',
    'Obtain an explicit independent CASE-06 policy disposition.',
    'Obtain a fresh exact-scope authorization from the established authority; never reuse a consumed one-shot.',
    'Repeat host/sandbox preflight and policy validation, then have the authorized gate custodian perform the documented gate transition.'
  ]
};
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--strict') && report.decision === 'BLOCKED_NOT_READY') process.exitCode = 2;
