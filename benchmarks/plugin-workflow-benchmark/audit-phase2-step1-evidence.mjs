#!/usr/bin/env node
// Read-only audit of the 2026-10-12 v3.8 CASE-01 pilot evidence bundle.
// It never mutates run records, authorizations, the official manifest, or the gate.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, readVerifiedRepoFile } from './phase2-approval-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const runDir = path.join(here, 'runs/phase2-pilot-20261012');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readEvidence = (file, label) => readVerifiedRepoFile(repo, path.relative(repo, path.join(runDir, file)).split(path.sep).join('/'), label);
const readJsonBytes = (bytes, label) => parseStrictJson(bytes, label);
const validSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Reconcile the durable consumption record against the actual immutable run
// record, not merely against another copy of the run ID/path. In particular,
// the run's scenario spec hash is the authorized execution spec hash recorded
// at consumption time; omitting this check could report a contradictory ledger
// row as reconciled while its binding points at a different spec.
export function reconcileHistoricalRunConsumption({ record, consumption, expectedOutputPath }) {
  const errors = [];
  if (record?.protocol !== 'cos-scenario-paired-v11') errors.push('run record protocol is missing or invalid');
  if (record?.case_id !== 'CASE-01' || consumption?.case_id !== record?.case_id) errors.push('run and consumption case scope do not match CASE-01');
  if (typeof record?.run_id !== 'string' || !record.run_id || consumption?.run_id !== record.run_id) errors.push('run ID does not reconcile');
  if (typeof consumption?.authorization_id !== 'string' || !consumption.authorization_id.trim()) errors.push('consumption authorization ID is missing');
  if (consumption?.protocol !== 'cos-phase2-authorization-consumption-v1') errors.push('consumption protocol is missing or invalid');
  if (consumption?.status !== 'consumed-before-workspace-or-model-invocation') errors.push('consumption status is not the required durable consumed state');
  if (typeof consumption?.output_path !== 'string' || path.resolve(consumption.output_path) !== path.resolve(expectedOutputPath)) errors.push('consumption output path does not bind the exact run record');
  if (!validSha256(consumption?.source_spec_sha256)) errors.push('consumption source spec SHA-256 is malformed');
  if (!validSha256(record?.scenario_spec_sha256) || !validSha256(consumption?.authorized_execution_spec_sha256) ||
      consumption.authorized_execution_spec_sha256 !== record.scenario_spec_sha256) {
    errors.push('consumption authorized execution spec SHA-256 does not match the run record scenario spec SHA-256');
  }
  return { valid: errors.length === 0, errors };
}

const records = [
  ['case-01-paired-v3.8.json', 'case-01-v3.8-authorization-consumed.json'],
  ['case-01-paired-v3.8-followup.json', 'case-01-v3.8-followup-authorization-consumed.json'],
  ['case-01-paired-v3.8-final-attempt.json', 'case-01-v3.8-final-attempt-authorization-consumed.json'],
  ['case-01-paired-v3.8-lineage-remediation.json', 'case-01-v3.8-lineage-remediation-authorization-consumed.json'],
  ['case-01-paired-v3.8-artifact-shape-remediation.json', 'case-01-v3.8-artifact-shape-remediation-authorization-consumed.json'],
  ['case-01-paired-v3.8-canonical-contract-remediation.json', 'case-01-v3.8-canonical-contract-remediation-authorization-consumed.json'],
  ['case-01-paired-v3.8-active-task-directive.json', 'case-01-v3.8-active-task-directive-authorization-consumed.json'],
];

const seenAuth = new Set();
const seenRun = new Set();
const inventory = [];
for (const [recordFile, consumptionFile] of records) {
  const recordBytes = readEvidence(recordFile, `historical run record ${recordFile}`).bytes;
  const record = readJsonBytes(recordBytes, `historical run record ${recordFile}`);
  const consumptionBytes = readEvidence(consumptionFile, `historical consumption record ${consumptionFile}`).bytes;
  const consumption = readJsonBytes(consumptionBytes, `historical consumption record ${consumptionFile}`);
  const reconciliation = reconcileHistoricalRunConsumption({
    record, consumption, expectedOutputPath: path.join(runDir, recordFile),
  });
  assert.equal(reconciliation.valid, true, `${consumptionFile}: ${reconciliation.errors.join('; ')}`);
  assert.ok(!seenAuth.has(consumption.authorization_id), `duplicate authorization ID ${consumption.authorization_id}`);
  assert.ok(!seenRun.has(record.run_id), `duplicate run ID ${record.run_id}`);
  seenAuth.add(consumption.authorization_id);
  seenRun.add(record.run_id);

  const plugin = record.conditions?.plugin;
  assert.ok(plugin, `${recordFile}: plugin condition missing`);
  const response = plugin.response ?? {};
  const lineage = plugin.plugin_artifact_lineage ?? response.plugin_artifact_lineage;
  assert.ok(lineage, `${recordFile}: lineage evidence missing`);
  assert.notEqual(lineage.status, 'verified', `${recordFile}: failed historical plugin lineage must not be upgraded`);
  const trace = response.tool_trace ?? [];
  const failedChecks = (lineage.checks ?? []).filter(c => c.passed === false).map(c => c.name);
  const counts = plugin.plugin_state_evidence?.table_counts ?? response.plugin_state_evidence?.table_counts ?? null;
  inventory.push({
    record: recordFile,
    record_sha256: sha256(recordBytes),
    consumption_record: consumptionFile,
    consumption_sha256: sha256(consumptionBytes),
    authorization_id: consumption.authorization_id,
    consumed_at: consumption.consumed_at,
    run_id: record.run_id,
    run_status: record.status,
    lineage_status: lineage.status,
    failed_lineage_checks: failedChecks,
    model_tool_calls: trace.filter(e => e.kind === 'model_tool_call').map(e => e.tool_name),
    workspace_proposal: trace.filter(e => e.kind === 'model_tool_call' && e.tool_name === 'custom_workflow_run_create').at(-1)?.arguments?.workspace ?? null,
    private_state_counts: counts,
  });
}

const draftEvidence = readVerifiedRepoFile(repo, 'benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.8-draft.json', 'v3.8 draft spec');
const manifestEvidence = readVerifiedRepoFile(repo, 'benchmarks/plugin-workflow-benchmark/runs/phase2-preparation-20261010/run-manifest.json', 'official run manifest');
const draft = readJsonBytes(draftEvidence.bytes, 'v3.8 draft spec');
const manifest = readJsonBytes(manifestEvidence.bytes, 'official run manifest');
assert.equal(draft.status, 'draft-not-authorized');
assert.equal(draft.execution_gate.status, 'blocked');
assert.deepEqual(draft.execution_gate.authorized_case_ids, []);
assert.equal(draft.execution_gate.authorization_record, null);
assert.equal(manifest.protocol.status, 'not-started');
assert.equal(manifest.assessment.final_status, 'not-started');

const out = {
  audit: 'phase2-step1-evidence-audit-v1',
  read_only: true,
  records_reviewed: inventory.length,
  unique_consumed_authorizations: seenAuth.size,
  all_consumption_records_reconcile: true,
  all_plugin_lineage_statuses_unverified_or_invalid: inventory.every(x => x.lineage_status !== 'verified'),
  official_gate_closed: true,
  official_manifest_not_started: true,
  inventory,
};
assert.equal(inventory.length, 7);
assert.equal(seenAuth.size, 7);
console.log(JSON.stringify(out, null, 2));
console.error(`PASS: audited ${inventory.length} immutable pilot records and ${seenAuth.size} matching consumed one-shot records; official gate remains closed.`);
