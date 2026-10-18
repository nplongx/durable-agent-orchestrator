import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, readVerifiedRepoFile, resolveVerifiedRepoPath, validateLegacyPhase2AuthorizationRecord, writeExclusiveVerifiedRepoFile, assertLegacyPhase2AuthorizationExecutionAllowed } from './phase2-approval-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
export const PHASE2_AUTHORIZATION_ID = 'phase2-case01-v3-one-shot-20261011-01';
export const draftSpecPath = path.join(here, 'scenario-execution-spec-v3-draft.json');
export const authorizedSpecPath = path.join(here, 'scenario-execution-spec-v3-case01-authorized-20261011.json');
export const authorizationRecordPath = path.join(here, 'phase2-case01-v3-execution-authorization-20261011.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function repoRelativePath(file, label) {
  const absolute = path.resolve(file);
  const relative = path.relative(repo, absolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`${label} must remain inside the repository root`);
  return relative;
}
function readAuthorityBytes(file, label) { return readVerifiedRepoFile(repo, repoRelativePath(file, label), label).bytes; }
function readAuthorityJson(file, label) { return parseStrictJson(readAuthorityBytes(file, label), label); }


export function validatePhase2Authorization({ specPath, specBytes, caseId, outputPath, runId, requireConsumed = false }) {
  assert.equal(path.resolve(specPath), path.resolve(authorizedSpecPath), 'only the one-case authorized v3 execution spec is eligible');
  const recordBytes = readAuthorityBytes(authorizationRecordPath, 'execution authorization record');
  const record = parseStrictJson(recordBytes, 'execution authorization record');
  validateLegacyPhase2AuthorizationRecord(record, { label: 'v3 authorization record', optionalTopKeys: ['consumed_run_id','result_path','result_status'],
    requireBubblewrapNetworkNamespace: true, expectedDecisionId: PHASE2_AUTHORIZATION_ID });
  const draftBytes = readAuthorityBytes(draftSpecPath, 'source scenario spec');
  const authorizedSpecBytes = readAuthorityBytes(specPath, 'authorized execution spec');
  assert.ok(Buffer.from(specBytes).equals(authorizedSpecBytes), 'caller spec bytes differ from verified canonical-path bytes');
  const spec = parseStrictJson(authorizedSpecBytes, 'authorized execution spec');
  assert.equal(path.resolve(repo, record.source_spec_path), path.resolve(draftSpecPath), 'authorization source-spec path differs from the fixed reviewed draft');
  assert.equal(path.resolve(repo, record.authorized_execution_spec_path), path.resolve(authorizedSpecPath), 'authorization execution-spec path differs from the fixed authorized spec');
  assert.equal(record.protocol, 'cos-phase2-one-case-execution-authorization-v1');
  assert.equal(record.decision_id, PHASE2_AUTHORIZATION_ID);
  assert.equal(record.decision, 'authorized-for-one-paired-CASE-01-v3-pilot-only');
  assert.equal(record.source_spec_sha256, sha256(draftBytes), 'source v3 draft hash changed after authorization');
  assert.equal(record.authorized_execution_spec_sha256, sha256(specBytes), 'authorized execution spec hash differs from authorization record');
  assert.equal(record.case_id, 'CASE-01');
  assert.equal(caseId, 'CASE-01', 'authorization is scoped to CASE-01 only');
  const authorizedOutputPath = resolveVerifiedRepoPath(repo, repoRelativePath(path.resolve(repo, record.output_path), 'authorized output path'), 'authorized output path');
  assert.equal(authorizedOutputPath.path, path.resolve(repo, record.output_path), 'authorized output path is not canonical');
  assert.equal(authorizedOutputPath.path, path.resolve(outputPath ?? record.output_path), 'output path differs from authorized path');
  assert.equal(spec.authorization_binding?.authorization_id, PHASE2_AUTHORIZATION_ID);
  assert.equal(spec.authorization_binding?.source_spec_sha256, record.source_spec_sha256);
  assert.equal(spec.execution_gate?.authorization_record?.decision_id, PHASE2_AUTHORIZATION_ID);
  assert.equal(spec.status, 'authorized-for-one-scenario');
  assert.equal(spec.execution_gate?.status, 'authorized');
  assert.deepEqual(spec.execution_gate?.authorized_case_ids, ['CASE-01']);
  const draft = parseStrictJson(draftBytes, 'source scenario spec');
  assert.deepEqual(spec.cases, draft.cases, 'authorized spec case content must be byte-semantically identical to reviewed draft');
  for (const key of Object.keys(draft)) {
    if (['status', 'execution_gate', 'authorization_binding'].includes(key)) continue;
    assert.deepEqual(spec[key], draft[key], `authorized spec changed reviewed field ${key}`);
  }
  const consumptionPathInfo = resolveVerifiedRepoPath(repo, record.consumption_record_path, 'authorization consumption path');
  const consumptionPath = consumptionPathInfo.path;
  if (requireConsumed) {
    assert.equal(record.consumption_status, 'fresh-not-yet-consumed', 'authorization was already consumed by a completed/failed run');
    assert.ok(runId, 'adapter requires the consuming run ID');
    const consumption = readAuthorityJson(consumptionPath, 'authorization consumption record');
    assert.equal(consumption.protocol, 'cos-phase2-authorization-consumption-v1');
    assert.equal(Object.keys(consumption).sort().join(','), 'authorization_id,authorized_execution_spec_sha256,case_id,consumed_at,output_path,protocol,run_id,source_spec_sha256,status', 'consumption record schema has unknown or missing keys');
    assert.equal(consumption.source_spec_sha256, record.source_spec_sha256, 'consumption source hash is detached from its authorization record');
    assert.equal(consumption.authorized_execution_spec_sha256, record.authorized_execution_spec_sha256, 'consumption authorized-spec hash is detached from its authorization record');
    assert.match(String(consumption.source_spec_sha256), /^[a-f0-9]{64}$/, 'consumption source hash must be strict SHA-256');
    assert.match(String(consumption.authorized_execution_spec_sha256), /^[a-f0-9]{64}$/, 'consumption authorized-spec hash must be strict SHA-256');
    assert.ok(typeof consumption.status === 'string' && consumption.status.trim(), 'consumption status is required');
    assert.ok(typeof consumption.run_id === 'string' && consumption.run_id.trim(), 'consumption run_id is required');
    const consumedAtMs = Date.parse(consumption.consumed_at);
    assert.ok(Number.isFinite(consumedAtMs) && new Date(consumedAtMs).toISOString() === consumption.consumed_at, 'consumed_at must be canonical UTC ISO-8601 with milliseconds');
    if (record.consumed_run_id !== undefined && record.consumed_run_id !== null) {
      assert.equal(consumption.run_id, record.consumed_run_id, 'consumption run ID conflicts with the immutable authorization record');
    }
assert.equal(consumption.authorization_id, PHASE2_AUTHORIZATION_ID);
    assert.equal(consumption.run_id, runId, 'consumption record run ID differs from current caller');
    assert.equal(consumption.case_id, 'CASE-01');
    assert.equal(path.resolve(consumption.output_path), path.resolve(outputPath ?? record.output_path));
  } else {
    assert.equal(record.consumption_status, 'fresh-not-yet-consumed', 'one-shot authorization record is already consumed');
    assert.equal(consumptionPathInfo.exists, false, 'one-shot authorization has already been consumed or has a pre-existing path entry');
    assertLegacyPhase2AuthorizationExecutionAllowed('legacy one-shot authorization');
  }
  return { record, consumptionPath, spec };
}

export function consumePhase2Authorization({ record, consumptionPath: requestedConsumptionPath, runId, outputPath }) {
  assert.equal(typeof runId, 'string');
  assert.ok(runId.trim(), 'consuming run ID is required');
  const current = validatePhase2Authorization({ specPath: authorizedSpecPath, specBytes: readAuthorityBytes(authorizedSpecPath, 'authorized execution spec'), caseId: 'CASE-01', outputPath, requireConsumed: false });
  assert.deepEqual(record, current.record, 'authorization object changed between validation and consumption');
  assert.equal(path.resolve(requestedConsumptionPath), current.consumptionPath, 'consumption target changed between validation and consumption');
  const consumptionPath = current.consumptionPath;
  const exactOutputPath = resolveVerifiedRepoPath(repo, repoRelativePath(outputPath, 'consuming output path'), 'consuming output path');
  assert.equal(exactOutputPath.path, path.resolve(outputPath), 'consuming output path is not canonical');
  assert.equal(exactOutputPath.path, path.resolve(repo, current.record.output_path), 'consuming output differs from authorized output path');

  const consumption = {
    protocol: 'cos-phase2-authorization-consumption-v1',
    authorization_id: PHASE2_AUTHORIZATION_ID,
    run_id: runId,
    case_id: 'CASE-01',
    output_path: path.resolve(outputPath),
    status: 'consumed-before-workspace-or-model-invocation',
    consumed_at: new Date().toISOString(),
    source_spec_sha256: record.source_spec_sha256,
    authorized_execution_spec_sha256: record.authorized_execution_spec_sha256,
  };
  const finalConsumption = resolveVerifiedRepoPath(repo, repoRelativePath(consumptionPath, 'consumption output path'), 'consumption output path');
  assert.equal(finalConsumption.exists, false, 'one-shot consumption path must remain absent at point of use');
  writeExclusiveVerifiedRepoFile(repo, repoRelativePath(consumptionPath, 'consumption output path'),
    `${JSON.stringify(consumption, null, 2)}\n`, 'authorization consumption record');
  if (process.env.NODE_ENV === 'test' && process.env.PHASE2_TEST_AUTH_CONSUMPTION_CRASH_AFTER_WRITE === 'SIGKILL') {
    process.kill(process.pid, 'SIGKILL');
  }
  return consumption;
}
