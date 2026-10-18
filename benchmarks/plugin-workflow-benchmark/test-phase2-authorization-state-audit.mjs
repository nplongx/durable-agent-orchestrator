#!/usr/bin/env node
// Pure synthetic tests for the read-only authorization-state reconciler.
import assert from 'node:assert/strict';
import { reconcileAuthorizationState } from './audit-phase2-v38-authorization-state.mjs';
import { reconcileHistoricalRunConsumption } from './audit-phase2-step1-evidence.mjs';

const manifest = { protocol: { status: 'not-started' }, assessment: { final_status: 'not-started' } };
const draft = { status: 'draft-not-authorized', execution_gate: { status: 'blocked', authorization_record: null, authorized_case_ids: [] } };
const record = {
  decision_id: 'one-shot-1', decision: 'authorized-for-one-paired-CASE-01-v3.8-pilot-only',
  case_id: 'CASE-01', output_path: 'runs/case01.json', source_spec_sha256: 'source-hash',
  authorized_execution_spec_sha256: 'spec-hash', consumption_status: 'fresh-not-yet-consumed',
  scope: { external_network: false, external_credentials: false, shared_runtime: false, opshub: false, other_cases: false, automatic_retry: false }
};
const consumption = {
  authorization_id: 'one-shot-1', status: 'consumed-before-workspace-or-model-invocation',
  case_id: 'CASE-01', run_id: 'run-1', output_path: 'runs/case01.json',
  source_spec_sha256: 'source-hash', authorized_execution_spec_sha256: 'spec-hash'
};

const result = reconcileAuthorizationState({ manifest, draft, record, consumption, sourceHash: 'source-hash', authorizedSpecHash: 'spec-hash' });
assert.equal(result.decision, 'BLOCKED_PRIOR_ONE_SHOT_CONSUMED');
assert.equal(result.prior_authorization_consumed, true);
assert.equal(result.authorization_record_metadata_stale, true);
assert.equal(result.official_gate_closed, true);
assert.equal(result.can_execute, false);

const changedHash = reconcileAuthorizationState({ manifest, draft, record, consumption, sourceHash: 'wrong-hash', authorizedSpecHash: 'spec-hash' });
assert.equal(changedHash.source_spec_hash_matches, false);
assert.equal(changedHash.can_execute, false);

const alteredGate = reconcileAuthorizationState({ manifest, draft: { ...draft, execution_gate: { ...draft.execution_gate, authorized_case_ids: ['CASE-01'] } }, record, consumption, sourceHash: 'source-hash', authorizedSpecHash: 'spec-hash' });
assert.equal(alteredGate.official_gate_closed, false);
assert.equal(alteredGate.can_execute, false);

const missingConsumption = reconcileAuthorizationState({ manifest, draft, record, consumption: null, sourceHash: 'source-hash', authorizedSpecHash: 'spec-hash' });
assert.equal(missingConsumption.prior_authorization_consumed, false);
assert.equal(missingConsumption.can_execute, false);

console.log('PASS: stale metadata cannot override durable one-shot consumption');
console.log('PASS: hash mismatches and changed official gate fail closed');
console.log('PASS: missing consumption evidence never opens execution');

const historicalRun = {
  protocol: 'cos-scenario-paired-v11', case_id: 'CASE-01', run_id: 'run-2',
  scenario_spec_sha256: 'a'.repeat(64),
};
const historicalConsumption = {
  protocol: 'cos-phase2-authorization-consumption-v1', authorization_id: 'one-shot-2',
  case_id: 'CASE-01', run_id: 'run-2', output_path: '/immutable/run.json',
  status: 'consumed-before-workspace-or-model-invocation', consumed_at: '2026-10-12T12:00:00.000Z',
  source_spec_sha256: 'b'.repeat(64), authorized_execution_spec_sha256: 'a'.repeat(64),
};
assert.equal(reconcileHistoricalRunConsumption({ record: historicalRun, consumption: historicalConsumption, expectedOutputPath: '/immutable/run.json' }).valid, true);
assert.equal(reconcileHistoricalRunConsumption({ record: historicalRun, consumption: { ...historicalConsumption, authorized_execution_spec_sha256: 'c'.repeat(64) }, expectedOutputPath: '/immutable/run.json' }).valid, false,
  'a ledger record bound to a different execution spec must not reconcile');
assert.equal(reconcileHistoricalRunConsumption({ record: historicalRun, consumption: { ...historicalConsumption, source_spec_sha256: 'not-a-hash' }, expectedOutputPath: '/immutable/run.json' }).valid, false,
  'malformed source-spec binding must not reconcile');
assert.equal(reconcileHistoricalRunConsumption({ record: historicalRun, consumption: { ...historicalConsumption, output_path: '/immutable/other.json' }, expectedOutputPath: '/immutable/run.json' }).valid, false,
  'a consumption record must bind the exact output record');
assert.equal(reconcileHistoricalRunConsumption({ record: historicalRun, consumption: { ...historicalConsumption, case_id: 'CASE-02' }, expectedOutputPath: '/immutable/run.json' }).valid, false,
  'a consumption record with conflicting case scope must not reconcile');
console.log('PASS: historical consumption reconciliation binds actual run protocol, case, exact output, source hash format and authorized execution-spec hash');
