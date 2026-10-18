#!/usr/bin/env node
// Offline consistency check for the final Phase 2 review dossier and case matrix.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePhase2Authorization, authorizedSpecPath } from './phase2-execution-authorization.mjs';
import { validatePhase2V31Authorization, authorizedV31SpecPath } from './phase2-v31-execution-authorization.mjs';
import { validatePhase2V32Authorization, authorizedV32SpecPath } from './phase2-v32-execution-authorization.mjs';
import { validatePhase2V33Authorization, authorizedV33SpecPath } from './phase2-v33-execution-authorization.mjs';
import { validatePhase2V34Authorization, authorizedV34SpecPath } from './phase2-v34-execution-authorization.mjs';
import { validatePhase2V35Authorization, authorizedV35SpecPath } from './phase2-v35-execution-authorization.mjs';
import { validatePhase2V36Authorization, authorizedV36SpecPath } from './phase2-v36-execution-authorization.mjs';
import { validatePhase2V37Authorization, authorizedV37SpecPath } from './phase2-v37-execution-authorization.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const read = p => fs.readFileSync(path.join(repo, p));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const specBytes = read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3-draft.json');
const spec = JSON.parse(specBytes.toString('utf8'));
const specHash = hash(specBytes);
const frozenBundleHash = '413cd1045d17a2779ca9fca4607a01faea62377fde416d039c288131b0dbc4aa';
const frozenBundlePath = path.join(repo, 'dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb');
const frozenBundleExists = fs.existsSync(frozenBundlePath);
if (frozenBundleExists) {
  assert.equal(hash(fs.readFileSync(frozenBundlePath)), frozenBundleHash, 'frozen bundle hash changed');
} else {
  // Preserve historical hash-binding checks without treating an unapproved
  // candidate as the missing frozen artifact or crashing on ENOENT.
  const candidateInventory = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-candidate-package-inventory-final4-20261013.json').toString('utf8'));
  assert.equal(candidateInventory.status, 'candidate-unapproved-review-evidence-only');
  assert.notEqual(candidateInventory.bundle.sha256, frozenBundleHash, 'candidate must never impersonate the frozen bundle');
  assert.equal(spec.status, 'draft-not-authorized');
  assert.equal(spec.execution_gate.status, 'blocked');
  assert.deepEqual(spec.execution_gate.authorized_case_ids, []);
}
const bundleHash = frozenBundleHash;
assert.equal(spec.status, 'draft-not-authorized');
assert.equal(spec.execution_gate.status, 'blocked');
assert.deepEqual(spec.execution_gate.authorized_case_ids, []);
assert.equal(spec.execution_gate.authorization_record, null);
const reviewFiles = [
  'benchmarks/plugin-workflow-benchmark/phase2-design-decision-proposal-20261011.md',
  'benchmarks/plugin-workflow-benchmark/phase2-preflight-readiness-review-20261011.md',
  'benchmarks/plugin-workflow-benchmark/phase2-case-permission-matrix-20261011.md',
];
for (const file of reviewFiles) {
  const body = read(file).toString('utf8');
  assert.ok(body.includes(specHash), `${file} is not bound to current v3 hash`);
  assert.ok(body.includes(bundleHash), `${file} is not bound to frozen bundle hash`);
}
const matrix = read(reviewFiles[2]).toString('utf8');
for (const item of spec.cases) {
  assert.ok(matrix.includes(`## ${item.case_id} — ${item.name}`), `case matrix missing ${item.case_id}`);
  for (const tool of item.plugin_tools) assert.ok(matrix.includes(tool), `${item.case_id} matrix missing granted tool ${tool}`);
}
const approval = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-spec-approval-20261011.json').toString('utf8'));
assert.equal(approval.spec_sha256, specHash, 'approval must bind exact approved v3 content');
assert.equal(approval.decision, 'approved-for-integration-review');
assert.equal(approval.execution_gate_must_remain, 'blocked');
assert.equal(approval.scope.benchmark_scenario_execution, false);
assert.equal(approval.scope.model_inference, false);
const snapshot = JSON.parse(read('benchmarks/plugin-workflow-benchmark/runs/phase2-preparation-20261010/phase2-host-permission-snapshot-20261011.json').toString('utf8'));
assert.equal(snapshot.frozen_bundle.sha256, bundleHash);
assert.equal(snapshot.v3_draft.sha256, specHash);
assert.equal(snapshot.benchmark_scenarios_executed, false);
assert.equal(snapshot.model_inference_executed, false);
const official = JSON.parse(read('benchmarks/plugin-workflow-benchmark/run-manifest.template.json').toString('utf8'));
assert.equal(official.protocol.status, 'not-started');
assert.equal(official.assessment.final_status, 'not-started');
const runManifest = JSON.parse(read('benchmarks/plugin-workflow-benchmark/runs/phase2-preparation-20261010/run-manifest.json').toString('utf8'));
assert.equal(runManifest.protocol.status, 'not-started');
assert.equal(runManifest.assessment.final_status, 'not-started');
const pilotPath = path.join(repo, 'benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-paired-v3.json');
assert.equal(fs.existsSync(pilotPath), true, 'authorized pilot evidence must be preserved');
const pilot = JSON.parse(fs.readFileSync(pilotPath, 'utf8'));
assert.equal(pilot.case_id, 'CASE-01');
assert.equal(pilot.status, 'scenario-run-recorded-with-failures-or-unverified-criteria');
assert.equal(pilot.benchmark_scenarios_executed, true);
assert.equal(pilot.conditions.control.verification.status, 'verified-by-independent-checks');
assert.notEqual(pilot.conditions.plugin.plugin_artifact_lineage.status, 'verified');
const consumptionPath = path.join(repo, 'benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-v3-authorization-consumed.json');
assert.equal(fs.existsSync(consumptionPath), true, 'one-shot authorization consumption must be durable');
const consumed = JSON.parse(fs.readFileSync(consumptionPath, 'utf8'));
assert.equal(consumed.run_id, pilot.run_id);
const auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3-execution-authorization-20261011.json').toString('utf8'));
assert.equal(auth.consumed_run_id, pilot.run_id);
assert.match(auth.consumption_status, /consumed/i);
assert.throws(() => validatePhase2Authorization({
  specPath: authorizedSpecPath,
  specBytes: read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3-case01-authorized-20261011.json'),
  caseId: 'CASE-01',
  outputPath: pilotPath,
}), /already consumed/i, 'consumed one-shot authorization must fail closed even if its consumption file is removed');
const remediation = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.1-draft.json').toString('utf8'));
assert.equal(remediation.status, 'draft-not-authorized');
assert.equal(remediation.execution_gate.status, 'blocked');
assert.deepEqual(remediation.execution_gate.authorized_case_ids, []);
assert.deepEqual(remediation.cases, spec.cases, 'remediation draft must preserve the ten frozen case prompts/policies');
assert.ok(read('benchmarks/plugin-workflow-benchmark/phase2-preflight-readiness-review-20261011.md').toString('utf8').includes(hash(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.1-draft.json'))));
assert.equal(official.protocol.status, 'not-started');
assert.equal(official.assessment.final_status, 'not-started');
const v31 = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.1-draft.json').toString('utf8'));
const v32Bytes = read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.2-draft.json');
const v32 = JSON.parse(v32Bytes.toString('utf8'));
assert.equal(v31.status, 'draft-not-authorized');
assert.equal(v32.status, 'draft-not-authorized');
assert.equal(v32.execution_gate.status, 'blocked');
assert.deepEqual(v32.execution_gate.authorized_case_ids, []);
assert.deepEqual(v32.cases, v31.cases, 'v3.2 remediation must preserve all case prompts and per-case grants');
assert.equal(v32.model.max_elapsed_seconds_per_condition, 2400);
const v31Pilot = JSON.parse(read('benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-paired-v3.1.json').toString('utf8'));
assert.equal(v31Pilot.status, 'scenario-run-recorded-with-failures-or-unverified-criteria');
assert.throws(() => validatePhase2V31Authorization({specPath:authorizedV31SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.1-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,'benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-paired-v3.1.json')}), /already.*consumed/i);
const v32Auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3.2-execution-authorization-20261011.json').toString('utf8'));
assert.match(v32Auth.consumption_status, /consumed/i);
assert.throws(() => validatePhase2V32Authorization({specPath:authorizedV32SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.2-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,v32Auth.output_path)}), /already.*consumed/i);
const v33 = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.3-draft.json').toString('utf8'));
assert.equal(v33.status, 'draft-not-authorized'); assert.equal(v33.execution_gate.status, 'blocked');
assert.deepEqual(v33.cases, v32.cases, 'v3.3 must preserve all frozen case prompts and grants');
const v33Auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3.3-execution-authorization-20261011.json').toString('utf8'));
assert.match(v33Auth.consumption_status, /consumed/i);
assert.throws(() => validatePhase2V33Authorization({specPath:authorizedV33SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.3-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,v33Auth.output_path)}), /already.*consumed/i);
console.log(`PASS: review dossier, case matrix, host snapshot, and v3 spec reconcile to the frozen bundle identity (${frozenBundleExists ? 'artifact present' : 'artifact missing; gate remains blocked'})`);
console.log('PASS: authorized one-shot pilot evidence and consumed authorization reconcile; plugin condition failed closed');
const v34 = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.4-draft.json').toString('utf8'));
assert.equal(v34.status, 'draft-not-authorized'); assert.equal(v34.execution_gate.status, 'blocked');
assert.deepEqual(v34.cases, v33.cases, 'v3.4 must preserve all frozen case prompts and grants');
const v34Auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3.4-execution-authorization-20261011.json').toString('utf8'));
assert.match(v34Auth.consumption_status, /consumed/i);
assert.throws(() => validatePhase2V34Authorization({specPath:authorizedV34SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.4-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,v34Auth.output_path)}), /already.*consumed/i);
const v35 = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.5-draft.json').toString('utf8'));
assert.equal(v35.status, 'draft-not-authorized'); assert.equal(v35.execution_gate.status, 'blocked');
assert.deepEqual(v35.cases, v34.cases, 'v3.5 must preserve all frozen case prompts and grants');
const v35Auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3.5-execution-authorization-20261011.json').toString('utf8'));
assert.match(v35Auth.consumption_status, /consumed/i);
assert.throws(() => validatePhase2V35Authorization({specPath:authorizedV35SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.5-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,v35Auth.output_path)}), /already.*consumed/i);
const v36 = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.6-draft.json').toString('utf8'));
assert.equal(v36.status, 'draft-not-authorized'); assert.equal(v36.execution_gate.status, 'blocked');
assert.deepEqual(v36.cases, v35.cases, 'v3.6 must preserve all frozen case prompts and grants');
assert.equal(v36.model.max_elapsed_seconds_per_condition, 3600); assert.equal(v36.model.model_request_timeout_ms, 480000);
const v36Auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3.6-execution-authorization-20261011.json').toString('utf8'));
assert.equal(v36Auth.consumption_status, 'consumed-before-workspace-or-model-invocation');
const v36Consumption = JSON.parse(read('benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-v3.6-authorization-consumed.json').toString('utf8'));
assert.equal(v36Auth.consumed_run_id, v36Consumption.run_id);
assert.equal(v36Auth.decision_id, v36Consumption.authorization_id);
assert.throws(() => validatePhase2V36Authorization({specPath:authorizedV36SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.6-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,v36Auth.output_path)}), /already.*consumed/i);
const v37 = JSON.parse(read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.7-draft.json').toString('utf8'));
assert.equal(v37.status, 'draft-not-authorized'); assert.equal(v37.execution_gate.status, 'blocked');
assert.deepEqual(v37.cases, v36.cases, 'v3.7 must preserve all frozen case prompts and grants');
assert.equal(v37.model.context_tokens, 8192); assert.equal(v37.model.max_predict_tokens, 1024);
assert.equal(v37.model.max_elapsed_seconds_per_condition, 5400); assert.equal(v37.model.model_request_timeout_ms, 600000);
const v37Auth = JSON.parse(read('benchmarks/plugin-workflow-benchmark/phase2-case01-v3.7-execution-authorization-20261011.json').toString('utf8'));
  assert.equal(v37Auth.consumption_status, 'consumed-before-workspace-or-model-invocation');
  const v37Consumption = JSON.parse(read('benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-v3.7-authorization-consumed.json').toString('utf8'));
  assert.equal(v37Consumption.authorization_id, v37Auth.decision_id);
  assert.equal(v37Consumption.status, v37Auth.consumption_status);
  assert.throws(() => validatePhase2V37Authorization({specPath:authorizedV37SpecPath,specBytes:read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.7-case01-authorized-20261011.json'),caseId:'CASE-01',outputPath:path.join(repo,v37Auth.output_path)}), /already consumed/i, 'consumed v3.7 authorization must fail closed');
const v38Bytes = read('benchmarks/plugin-workflow-benchmark/scenario-execution-spec-v3.8-draft.json');
const v38 = JSON.parse(v38Bytes.toString('utf8'));
assert.equal(v38.status, 'draft-not-authorized'); assert.equal(v38.execution_gate.status, 'blocked');
assert.deepEqual(v38.execution_gate.authorized_case_ids, []); assert.equal(v38.execution_gate.authorization_record, null);
assert.deepEqual(v38.cases, v37.cases, 'v3.8 must preserve all frozen case prompts and grants');
assert.deepEqual(v38.model, v37.model, 'v3.8 context-only candidate must not alter model/runtime limits');
assert.ok(v38.system_context.length < v37.system_context.length, 'v3.8 must reduce shared context size');
for (const v of ['3','3.1','3.2','3.3','3.4','3.5','3.6','3.7']) {
  const historical = JSON.parse(read(`benchmarks/plugin-workflow-benchmark/phase2-case01-v${v}-execution-authorization-20261011.json`).toString('utf8'));
  assert.ok(v38.execution_gate.previous_authorization_records.some(x => x.decision_id === historical.decision_id), `v3.8 history missing consumed authorization v${v}`);
  assert.match(historical.consumption_status, /consumed/i, `historical authorization v${v} must remain consumed`);
  const historicalConsumption = JSON.parse(read(`benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-v${v}-authorization-consumed.json`).toString('utf8'));
  assert.equal(historicalConsumption.authorization_id, historical.decision_id, `v${v} consumption record authorization ID mismatch`);
  assert.equal(historicalConsumption.case_id, 'CASE-01', `v${v} consumption record must remain scoped to CASE-01`);
  assert.match(historicalConsumption.status, /consumed/i, `v${v} durable consumption record must remain consumed`);
  if (historical.consumed_run_id) assert.equal(historicalConsumption.run_id, historical.consumed_run_id, `v${v} consumed run ID mismatch`);
}
assert.ok(read('benchmarks/plugin-workflow-benchmark/phase2-preflight-readiness-review-20261011.md').toString('utf8').includes(hash(v38Bytes)), 'review dossier must bind exact v3.8 draft hash');
console.log('PASS: v3.1 through v3.8 remediation drafts preserve prompts/policies and remain blocked; consumed authorizations cannot be reused');
console.log('PASS: official manifest remains not-started');
console.log('PASS: all ten case tool grants remain represented in the review matrix');
